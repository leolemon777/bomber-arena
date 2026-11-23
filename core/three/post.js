// What happens to a frame after the scene is drawn, in a fixed order:
//
//   scene (color, depth, normals, motion) -> ambient occlusion (half size) -> exposure
//   -> bloom -> TRAA anti-aliasing -> tone mapping and sRGB -> grade -> vignette (grain only when a game asks for it)
//
// The order matters. Exposure comes before bloom: under the physical sky the scene is in the tens,
// far above bloom's threshold, and a bloom taken before exposure spreads over the whole frame as a
// grey haze. The grade works on display colors, after tone mapping. The film grain's seed is
// each pixel's own position and the frame, since one large product of a coordinate bands into
// stripes. The values come from the game's lighting (lighting.look).
import * as THREE from "three";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import {
  colorToDirection,
  directionToColor,
  hash,
  length,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  sample,
  screenCoordinate,
  screenUV,
  smoothstep,
  time,
  vec2,
  vec3,
  vec4,
  velocity,
} from "three/tsl";

/** The game's own bloom, kept from the template's earlier composer: subtle, for bright accents. */
const BLOOM = { strength: 0.3, radius: 0.38, threshold: 1.2 };

export function createPipeline(renderer, scene, camera, look) {
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: directionToColor(normalView), velocity }));
  scenePass.getTexture("normal").type = THREE.UnsignedByteType;
  const color = scenePass.getTextureNode("output");
  const depth = scenePass.getTextureNode("depth");
  const normalTexture = scenePass.getTextureNode("normal");
  const motion = scenePass.getTextureNode("velocity");
  const normal = sample((uv) => colorToDirection(normalTexture.sample(uv)));

  const occlusionPass = ao(depth, normal, camera);
  occlusionPass.resolutionScale = 0.5;
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  let mode;
  let temporal;
  let bloomPass;

  function configure() {
    const next = `${look.occlusion.value > 0}:${look.bloom.value > 0}`;
    if (mode === next) return;
    mode = next;
    temporal?.dispose();
    bloomPass?.dispose();
    const occlusion =
      look.occlusion.value > 0 ? mix(1, occlusionPass.getTextureNode().r, look.occlusion) : 1;

    const exposed = vec4(color.rgb.mul(look.exposure).mul(occlusion), color.a);
    bloomPass =
      look.bloom.value > 0 ? bloom(exposed, BLOOM.strength, BLOOM.radius, BLOOM.threshold) : null;
    const bloomed = bloomPass ? exposed.add(bloomPass.mul(look.bloom)) : exposed;
    temporal = traa(bloomed, depth, motion, camera);
    const display = renderOutput(temporal);

    const g = look.grade;
    const tinted = display.rgb.mul(g.tint);
    const l = luminance(tinted);
    const saturated = mix(vec3(l), tinted, g.saturation);
    const contrasted = saturated.sub(0.5).mul(g.contrast).add(0.5);
    const graded = contrasted.add(mix(g.shadows, g.highlights, smoothstep(0.15, 0.85, l)));
    const edge = length(screenUV.sub(0.5).mul(vec2(1, 0.9)));
    const vignette = mix(1, smoothstep(0.85, 0.35, edge).mul(0.28).add(0.72), look.vignette);
    const seed = screenCoordinate.x
      .add(screenCoordinate.y.mul(4096))
      .add(time.mul(60).floor().mul(7919));
    const grain = hash(seed).sub(0.5).mul(0.035).mul(look.grain);

    pipeline.outputNode = vec4(graded.mul(vignette).add(grain).clamp(0, 1), 1);

    pipeline.needsUpdate = true;
  }

  return {
    /** Compile the actual MRT scene pass, including dormant weather, before the loop starts. */
    async prepare() {
      configure();
      const hidden = [];
      scene.traverse((object) => {
        if (object.userData.prewarm && !object.visible) {
          hidden.push(object);
          object.visible = true;
        }
      });
      const target = renderer.getRenderTarget();
      const mrt = renderer.getMRT();
      const context = renderer.contextNode;
      try {
        await scenePass.compileAsync(renderer);
      } finally {
        // PassNode does not restore these on a failed compile.
        renderer.setRenderTarget(target);
        renderer.setMRT(mrt);
        renderer.contextNode = context;
        hidden.forEach((object) => (object.visible = false));
      }
    },
    /** Disabled effects are absent from the graph, including their render passes. */
    render() {
      configure();
      pipeline.render();
    },
    dispose() {
      temporal?.dispose();
      bloomPass?.dispose();
      occlusionPass.dispose();
      scenePass.dispose();
      pipeline.dispose();
    },
  };
}
