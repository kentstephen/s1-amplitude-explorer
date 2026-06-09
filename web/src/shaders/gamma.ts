import type { ShaderModule } from "@luma.gl/shadertools";

const MODULE_NAME = "gamma";

/**
 * Gamma / contrast curve on the [0,1] grayscale (or pre-colormap) value.
 *
 * `value > 1` pushes midtones toward black (inky shadows, bright foreslopes —
 * the cinematic SAR look); `value < 1` lifts them. `1.0` is linear. Applied
 * after `LinearRescale` and before any `Colormap`, so it reshapes both grayscale
 * brightness and the colormap index distribution.
 */
export const Gamma = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  float value;
} ${MODULE_NAME};
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      color.rgb = pow(max(color.rgb, 0.0), vec3(${MODULE_NAME}.value));
    `,
  },
  uniformTypes: {
    value: "f32",
  },
  getUniforms: (props: { value?: number }) => ({
    value: props.value ?? 1.0,
  }),
} as const satisfies ShaderModule<{ value: number }>;
