import { lights } from "three/tsl";

/** Animated surfaces use the live environment, without adding a fixed level's baked sky twice. */
export function withEnvironmentLighting(Material) {
  return class extends Material {
    setupLighting(builder) {
      const original = builder.lightsNode;
      if (!original) {
        return super.setupLighting(builder);
      }
      builder.lightsNode = lights(original.getLights().filter((light) => !light.isLightProbeGrid));
      try {
        return super.setupLighting(builder);
      } finally {
        builder.lightsNode = original;
      }
    }
  };
}
