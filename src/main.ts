import { Matrix4, Mesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshBVH } from "three-mesh-bvh";
import buildTracerShader from "./tracer-shader";
import buildRenderShader from "./render-shader";
import { logGroup } from "./cpu-performance-logger";
import { consolidateMesh } from "./consolidate-mesh";
import { OpenPBRMaterial } from "./openpbr-material";
import {
  getSizeAndAlignmentOfUnsizedArrayElement,
  makeShaderDataDefinitions,
  makeStructuredView,
} from "webgpu-utils";

const DUCK_MODEL_URL = "models/duck/Duck.gltf";

const gltfLoader = new GLTFLoader();

async function loadGltf(url: string) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, resolve, undefined, reject);
  });
}

// Build constants
const BYTES_PER_NODE = 6 * 4 + 4 + 4;

// See https://github.com/gkjohnson/three-mesh-bvh/blob/0eda7b718799e1709ad9efecdcc13c06ae3d5a55/src/core/utils/nodeBufferUtils.js
function isLeaf(n16: number, uint16Array: Uint16Array) {
  return uint16Array[n16 + 15] === 0xffff;
}

function getAtOffset(n32: number, uint32Array: Uint32Array) {
  return uint32Array[n32 + 6];
}

function getCount(n16: number, uint16Array: Uint16Array) {
  return uint16Array[n16 + 14];
}

function getLeftNode(n32: number) {
  return n32 + 8;
}

function getRightNode(n32: number, uint32Array: Uint32Array) {
  return uint32Array[n32 + 6];
}

function getSplitAxis(n32: number, uint32Array: Uint32Array) {
  return uint32Array[n32 + 7];
}

function getBoundingDataIndex(n32: number) {
  return n32;
}

type MeshBVHInternal = {
  _roots: ArrayBuffer[];
};

// Inspired by https://github.com/gkjohnson/three-mesh-bvh/blob/0eda7b718799e1709ad9efecdcc13c06ae3d5a55/src/gpu/MeshBVHUniformStruct.js#L110C1-L191C2
function bvhToTextures(bvh: MeshBVH) {
  const privateBvh = bvh as unknown as MeshBVHInternal;
  const roots = privateBvh._roots;

  if (roots.length !== 1) {
    throw new Error("MeshBVHUniformStruct: Multi-root BVHs not supported.");
  }

  const root = roots[0];
  const uint16Array = new Uint16Array(root);
  const uint32Array = new Uint32Array(root);
  const float32Array = new Float32Array(root);

  // Both bounds need two elements per node so compute the height so it's twice as long as
  // the width so we can expand the row by two and still have a square texture
  const nodeCount = root.byteLength / BYTES_PER_NODE;
  const boundsDimension = 2 * Math.ceil(Math.sqrt(nodeCount / 2));
  const boundsArray = new Float32Array(4 * boundsDimension * boundsDimension);

  const contentsDimension = Math.ceil(Math.sqrt(nodeCount));
  const contentsArray = new Uint32Array(
    2 * contentsDimension * contentsDimension,
  );

  for (let i = 0; i < nodeCount; i++) {
    const nodeIndex32 = (i * BYTES_PER_NODE) / 4;
    const nodeIndex16 = nodeIndex32 * 2;
    const boundsIndex = getBoundingDataIndex(nodeIndex32);
    for (let b = 0; b < 3; b++) {
      boundsArray[8 * i + 0 + b] = float32Array[boundsIndex + 0 + b];
      boundsArray[8 * i + 4 + b] = float32Array[boundsIndex + 3 + b];
    }

    if (isLeaf(nodeIndex16, uint16Array)) {
      const count = getCount(nodeIndex16, uint16Array);
      const offset = getAtOffset(nodeIndex32, uint32Array);

      const mergedLeafCount = 0xffff0000 | count;
      contentsArray[i * 2 + 0] = mergedLeafCount;
      contentsArray[i * 2 + 1] = offset;
    } else {
      const rightIndex =
        (4 * getRightNode(nodeIndex32, uint32Array)) / BYTES_PER_NODE;
      const splitAxis = getSplitAxis(nodeIndex32, uint32Array);

      contentsArray[i * 2 + 0] = splitAxis;
      contentsArray[i * 2 + 1] = rightIndex;
    }
  }

  return {
    boundsArray,
    contentsArray,
    boundsDimension,
    contentsDimension,
  };
}

async function run() {
  const duck = await loadGltf(DUCK_MODEL_URL);

  const duckMesh = duck.scene.children[0].children[0] as Mesh;

  const initLog = logGroup("init");
  const canvas = document.getElementById("render-target");

  if (!(canvas instanceof HTMLCanvasElement)) {
    console.error("No canvas found");
    return;
  }

  if (!navigator.gpu) {
    console.error("WebGPU is not supported in your browser");
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    console.error("No adapter found");
    return;
  }

  const device = await adapter.requestDevice({
    requiredFeatures: ["timestamp-query"],
  });

  const timestampQuerySet = device.createQuerySet({
    type: "timestamp",
    count: 2,
  });

  const timestampQueryResolveBuffer = device.createBuffer({
    size: timestampQuerySet.count * 8,
    usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.QUERY_RESOLVE,
  });

  const timestampQueryResultBuffer = device.createBuffer({
    size: timestampQueryResolveBuffer.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const context = canvas.getContext("webgpu");

  if (!context) {
    console.error("No context found");
    return;
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
  });

  const kTextureWidth = 1024;
  const kTextureHeight = kTextureWidth;

  const imageWidth = kTextureWidth;
  const imageHeight = imageWidth;

  const maxWorkgroupDimension = 16;

  const tracerShaderCode = buildTracerShader({
    imageWidth,
    imageHeight,
    maxWorkgroupDimension,
  });

  const textureData = new Uint8Array(kTextureWidth * kTextureHeight * 4);

  const texture = device.createTexture({
    size: [kTextureWidth, kTextureHeight],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.STORAGE_BINDING, // Permit writting to texture in compute shader
  });

  device.queue.writeTexture(
    { texture },
    textureData,
    { bytesPerRow: kTextureWidth * 4 },
    { width: kTextureWidth, height: kTextureHeight },
  );

  const sampler = device.createSampler();

  const renderShaderModule = device.createShaderModule({
    label: "Render Shader",
    code: buildRenderShader(),
  });

  const renderBindGroupLayout = device.createBindGroupLayout({
    label: "Texture sampler bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
    ],
  });

  const renderPipelineLayout = device.createPipelineLayout({
    label: "Pipeline Layout",
    bindGroupLayouts: [renderBindGroupLayout],
  });

  const renderBindGroup = device.createBindGroup({
    label: "Texture sampler bind group",
    layout: renderBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: sampler,
      },
      {
        binding: 1,
        resource: texture.createView(),
      },
    ],
  });

  const renderPipeline = device.createRenderPipeline({
    label: "Render pipeline",
    layout: renderPipelineLayout,
    vertex: {
      module: renderShaderModule,
      entryPoint: "vertexMain",
      buffers: [],
    },
    fragment: {
      module: renderShaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format,
        },
      ],
    },
  });

  // Prepare Position Data

  // todo: remove magic downscaling & transform
  const scaleFactor = 0.01;
  const scaleMatrix = new Matrix4().makeScale(
    scaleFactor,
    scaleFactor,
    scaleFactor,
  );
  duckMesh.geometry.applyMatrix4(scaleMatrix);

  const translateX = 0;
  const translateY = -1;
  const translateZ = -2;

  const transformMatrix = new Matrix4().makeTranslation(
    translateX,
    translateY,
    translateZ,
  );

  duckMesh.geometry.applyMatrix4(transformMatrix);

  const reducedModel = consolidateMesh([duckMesh]);

  reducedModel.geometry.applyMatrix4(transformMatrix);
  reducedModel.boundsTree = new MeshBVH(reducedModel.geometry, {
    indirect: true,
  });
  const boundsTree = reducedModel.boundsTree;

  const { boundsArray, contentsArray } = bvhToTextures(boundsTree);

  const meshPositions = boundsTree.geometry.attributes.position.array;

  const positions = meshPositions;

  const positionBuffer = device.createBuffer({
    label: "Position buffer",
    size: Float32Array.BYTES_PER_ELEMENT * positions.length,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });

  const positionMapped = positionBuffer.getMappedRange();
  const positionData = new Float32Array(positionMapped);

  positionData.set(positions);
  positionBuffer.unmap();

  // Prepare Indices
  const meshIndices = boundsTree.geometry.index!.array;

  const indices = new Uint32Array(meshIndices);

  const indicesBuffer = device.createBuffer({
    label: "Index buffer",
    size: Uint32Array.BYTES_PER_ELEMENT * indices.length,
    // todo: consider using GPUBufferUsage.INDEX
    usage: GPUBufferUsage.STORAGE, // GPUBufferUsage.INDEX,
    mappedAtCreation: true,
  });

  const indicesMapped = indicesBuffer.getMappedRange();
  const indicesData = new Uint32Array(indicesMapped);
  indicesData.set(indices);
  indicesBuffer.unmap();

  // Prepare Normal Data
  const normals = boundsTree.geometry.attributes.normal.array;

  const normalBuffer = device.createBuffer({
    label: "Normal buffer",
    size: Float32Array.BYTES_PER_ELEMENT * normals.length,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });

  const normalMapped = normalBuffer.getMappedRange();
  const normalData = new Float32Array(normalMapped);
  normalData.set(normals);
  normalBuffer.unmap();

  // Prepare BVH Bounds
  const boundsBuffer = device.createBuffer({
    label: "BVH bounds buffer",
    size: Float32Array.BYTES_PER_ELEMENT * boundsArray.length,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });

  const boundsMapped = boundsBuffer.getMappedRange();
  const boundsData = new Float32Array(boundsMapped);
  boundsData.set(boundsArray);
  boundsBuffer.unmap();

  // Prepare BVH Contents
  const contentsBuffer = device.createBuffer({
    label: "BVH contents buffer",
    size: Uint32Array.BYTES_PER_ELEMENT * contentsArray.length,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });

  const contentsMapped = contentsBuffer.getMappedRange();
  const contentsData = new Uint32Array(contentsMapped);
  contentsData.set(contentsArray);
  contentsBuffer.unmap();

  // Prepare BVH indirect buffer
  const indirectBuffer = device.createBuffer({
    label: "BVH indirect buffer",
    size: Uint32Array.BYTES_PER_ELEMENT * boundsTree._indirectBuffer.length,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });

  const indirectMapped = indirectBuffer.getMappedRange();
  const indirectData = new Uint32Array(indirectMapped);
  indirectData.set(boundsTree._indirectBuffer);
  indirectBuffer.unmap();

  // Prepare Object Definitions
  const OBJECT_DEFINITION_SIZE_PER_ENTRY = Uint32Array.BYTES_PER_ELEMENT * 3;
  const groups = reducedModel.geometry.groups;

  const objectDefinitionsBuffer = device.createBuffer({
    label: "Object definitions buffer",
    size: OBJECT_DEFINITION_SIZE_PER_ENTRY * groups.length,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });

  const objectDefinitionsMapped = objectDefinitionsBuffer.getMappedRange();
  const objectDefinitionsData = new Uint32Array(objectDefinitionsMapped);

  objectDefinitionsData.set(
    groups.map((g) => [g.start, g.count, g.materialIndex]).flat(1),
  );
  objectDefinitionsBuffer.unmap();

  // Prepare Material Definitions
  const material = new OpenPBRMaterial();
  material.oBaseWeight = 1.0;
  material.oBaseColor = [1.0, 0.2, 0.2];

  // todo: define based on model
  const materials = [material];

  const definitions = makeShaderDataDefinitions(tracerShaderCode);
  const { size: bytesPerMaterial } = getSizeAndAlignmentOfUnsizedArrayElement(
    definitions.storages.materials,
  );

  const materialDataView = makeStructuredView(
    definitions.storages.materials,
    new ArrayBuffer(bytesPerMaterial * materials.length),
  );

  const materialBuffer = device.createBuffer({
    label: "Material buffer",
    size: bytesPerMaterial * materials.length,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });

  const materialMapped = materialBuffer.getMappedRange();
  const materialData = new Float32Array(materialMapped);

  materialDataView.set(
    materials.map((m) => ({
      baseWeight: m.oBaseWeight,
      baseColor: m.oBaseColor,
      baseDiffuseRoughness: m.oBaseDiffuseRoughness,
      baseMetalness: m.oBaseMetalness,
      specularWeight: m.oSpecularWeight,
      specularColor: m.oSpecularColor,
      specularRoughness: m.oSpecularRoughness,
      specularAnisotropy: m.oSpecularRoughnessAnisotropy,
      specularRotation: m.oSpecularRoughnessRotation,
      coatWeight: m.oCoatWeight,
      coatRoughness: m.oCoatRoughness,
      emissionLuminance: m.oEmissionLuminance,
      emissionColor: m.oEmissionColor,
      thinFilmThickness: m.oThinFilmThickness,
      thinFilmIOR: m.oThinFilmIOR,
    })),
  );

  // todo: check if Flaot32Array is strictly necessary
  materialData.set(new Float32Array(materialDataView.arrayBuffer));

  materialBuffer.unmap();

  const computeBindGroupLayout = device.createBindGroupLayout({
    label: "Compute bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { format: "rgba8unorm" /*, access: "write-only"*/ },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 7,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 8,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
    ],
  });

  const computePipelineLayout = device.createPipelineLayout({
    label: "Compute pipeline layout",
    bindGroupLayouts: [computeBindGroupLayout],
  });

  const computeBindGroup = device.createBindGroup({
    label: "Compute bind group",
    layout: computeBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: texture.createView(),
      },
      {
        binding: 1,
        resource: {
          buffer: positionBuffer,
        },
      },
      {
        binding: 2,
        resource: {
          buffer: indicesBuffer,
        },
      },
      {
        binding: 3,
        resource: {
          buffer: boundsBuffer,
        },
      },
      {
        binding: 4,
        resource: {
          buffer: contentsBuffer,
        },
      },
      {
        binding: 5,
        resource: {
          buffer: normalBuffer,
        },
      },
      {
        binding: 6,
        resource: {
          buffer: indirectBuffer,
        },
      },
      {
        binding: 7,
        resource: {
          buffer: objectDefinitionsBuffer,
        },
      },
      {
        binding: 8,
        resource: {
          buffer: materialBuffer,
        },
      },
    ],
  });

  const computePasses = Math.ceil(
    // todo: check…
    (imageWidth * imageWidth) / maxWorkgroupDimension,
  );

  const computeShaderModule = device.createShaderModule({
    label: "Ray Tracing Compute Shader",
    code: tracerShaderCode,
  });

  const computePipeline = device.createComputePipeline({
    label: "Ray Tracing Compute pipeline",
    layout: computePipelineLayout,
    compute: {
      module: computeShaderModule,
      entryPoint: "computeMain",
    },
  });

  initLog.end();

  const computeLog = logGroup("compute");

  let TARGET_FRAMES = 0;
  let frame = 0;
  const render = async () => {
    const encoder = device.createCommandEncoder();

    const computePass = encoder.beginComputePass({
      timestampWrites: {
        querySet: timestampQuerySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    computePass.setBindGroup(0, computeBindGroup);

    computePass.setPipeline(computePipeline);
    computePass.dispatchWorkgroups(
      Math.sqrt(computePasses),
      Math.sqrt(computePasses),
    );

    computePass.end();

    encoder.resolveQuerySet(
      timestampQuerySet,
      0,
      2,
      timestampQueryResolveBuffer,
      0,
    );

    if (timestampQueryResultBuffer.mapState === "unmapped") {
      encoder.copyBufferToBuffer(
        timestampQueryResolveBuffer,
        0,
        timestampQueryResultBuffer,
        0,
        timestampQueryResolveBuffer.size,
      );
    }

    computeLog.end();
    const renderLog = logGroup("render");

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0.2, a: 1 },
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(renderPipeline);

    pass.setBindGroup(0, renderBindGroup);
    const RENDER_TEXTURE_VERTEX_COUNT = 6;
    pass.draw(RENDER_TEXTURE_VERTEX_COUNT);

    pass.end();

    const commandBuffer = encoder.finish();
    renderLog.end();

    const queueSubmitLog = logGroup("queue submit");
    device.queue.submit([commandBuffer]);

    if (timestampQueryResultBuffer.mapState === "unmapped") {
      await timestampQueryResultBuffer.mapAsync(GPUMapMode.READ);
      const data = new BigUint64Array(
        timestampQueryResultBuffer.getMappedRange(),
      );
      const gpuTime = data[1] - data[0];
      console.log(`GPU Time: ${gpuTime}ns`);
      timestampQueryResultBuffer.unmap();
    }

    queueSubmitLog.end();

    if (frame < TARGET_FRAMES) {
      frame++;
      requestAnimationFrame(render);
    }
  };
  requestAnimationFrame(render);
}

run();
