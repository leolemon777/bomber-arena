// A planar water surface using three.js's reflector and the scene's PBR diffuse light.
// Reflection, sun glint and water body stay in linear scene units until the shared post pipeline.
import * as THREE from "three/webgpu";
import {
  cameraPosition,
  cameraViewMatrix,
  mix,
  normalize,
  positionWorld,
  reflect,
  reflector,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { withEnvironmentLighting } from "./materials.js";

/**
 * A tiling normal map of soft ripples, drawn once in a canvas from summed sine waves, so the water
 * needs no image file.
 */
function rippleNormals(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const image = g.createImageData(size, size);
  const waves = Array.from({ length: 12 }, (_, i) => ({
    kx: Math.round(Math.cos(i * 2.4) * (2 + i)),
    ky: Math.round(Math.sin(i * 2.4) * (2 + i)),
    phase: i * 1.7,
    amp: 1 / (1 + i * 0.6),
  }));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const a = ((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.phase;
        const c = Math.cos(a) * w.amp;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      const n = new THREE.Vector3(-dx * 0.04, -dy * 0.04, 1).normalize();
      const i = (y * size + x) * 4;
      image.data[i] = (n.x * 0.5 + 0.5) * 255;
      image.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      image.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Diffuse water body plus a Fresnel reflection, with no second environment specular term. */
class WaterMaterial extends withEnvironmentLighting(THREE.MeshPhysicalNodeMaterial) {
  constructor(reflection, reflectance, glint) {
    super({ roughness: 1, metalness: 0, specularIntensity: 0 });
    this.reflectionNode = reflection;
    this.reflectanceNode = reflectance;
    this.glintNode = glint;
  }

  setupLighting(builder) {
    const body = super.setupLighting(builder);
    return mix(body, this.reflectionNode.rgb.add(this.glintNode), this.reflectanceNode);
  }
}

/** A horizontal lake or sea. Update after changing the light; dispose also frees its reflection. */
export function createWater(
  lighting,
  {
    width = 200,
    depth = 200,
    color = "#1d4f5c",
    ripple = 0.25,
    distortion = 3.5,
    resolutionScale = 0.5,
  } = {},
) {
  const normals = texture(rippleNormals());
  const size = uniform(ripple);
  const distortionScale = uniform(distortion);
  const waterColor = uniform(new THREE.Color(color));
  const sunColor = uniform(new THREE.Color());
  const sunIntensity = uniform(0);
  const sunDirection = uniform(new THREE.Vector3(0, 1, 0));
  const uv = positionWorld.xz.mul(size);
  // The four drifting normal samples follow WaterMesh's waves (three.js, MIT).
  const noise = normals
    .sample(uv.div(103).add(vec2(time.div(17), time.div(29))))
    .add(normals.sample(uv.div(107).sub(vec2(time.div(-19), time.div(31)))))
    .add(normals.sample(uv.div(vec2(8907, 9803)).add(vec2(time.div(101), time.div(97)))))
    .add(normals.sample(uv.div(vec2(1091, 1027)).sub(vec2(time.div(109), time.div(-113)))))
    .mul(0.5)
    .sub(1);
  const normal = normalize(noise.xzy.mul(vec3(1.5, 1, 1.5)));
  const toEye = cameraPosition.sub(positionWorld);
  const eye = normalize(toEye);
  const distortionUV = normal.xz
    .mul(toEye.length().max(0.1).reciprocal().add(0.001))
    .mul(distortionScale);
  // Create and attach outside a shader Fn: compilation must not mutate the scene it is building.
  const reflection = reflector({ resolutionScale, bounces: false });
  reflection.uvNode = reflection.uvNode.add(distortionUV);
  const fresnel = normal.dot(eye).clamp().oneMinus().pow(5).mul(0.98).add(0.02);
  const glint = reflect(sunDirection.negate(), normal)
    .dot(eye)
    .max(0)
    .pow(100)
    .mul(sunColor)
    .mul(sunIntensity)
    .mul(2);
  const material = new WaterMaterial(reflection, fresnel, glint);
  material.colorNode = waterColor;
  material.normalNode = cameraViewMatrix.mul(vec4(normal, 0)).xyz.normalize();
  const water = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  water.rotation.x = -Math.PI / 2;
  water.add(reflection.target);
  // Keep the editable uniforms on the surface, like WaterMesh, for wave animation.
  Object.assign(water, {
    size,
    distortionScale,
    waterColor,
    sunColor,
    sunIntensity,
    sunDirection,
    waterNormals: normals,
  });
  water.update = () => {
    const { sun } = lighting;
    sunDirection.value.copy(sun.position).normalize();
    sunColor.value.copy(sun.color);
    sunIntensity.value = sun.visible ? sun.intensity : 0;
  };
  water.update();
  let disposed = false;
  water.dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    water.removeFromParent();
    reflection.dispose();
    water.geometry.dispose();
    material.dispose();
    normals.value.dispose();
  };
  return water;
}
