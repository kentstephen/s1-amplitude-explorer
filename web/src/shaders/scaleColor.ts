import type { ShaderModule } from "@luma.gl/shadertools";

const MODULE_NAME = "scaleColor";

/**
 * Multiply the final RGB by a scalar. Use as the last module in a pipeline
 * to dim or boost the whole frame uniformly without touching the mapping
 * from data → color. Values < 1 darken; > 1 brighten (clipped to 1).
 *
 * Alpha is left untouched.
 */
export const ScaleColor = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  float factor;
} ${MODULE_NAME};
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      color.rgb = color.rgb * ${MODULE_NAME}.factor;
    `,
  },
  uniformTypes: {
    factor: "f32",
  },
  getUniforms: (props: { factor?: number }) => ({
    factor: props.factor ?? 1.0,
  }),
} as const satisfies ShaderModule<{ factor: number }>;
