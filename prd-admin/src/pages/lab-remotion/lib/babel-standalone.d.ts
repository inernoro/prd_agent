declare module '@babel/standalone' {
  interface TransformOptions {
    presets?: string[];
    plugins?: string[];
    filename?: string;
    sourceType?: 'script' | 'module' | 'unambiguous';
  }

  interface TransformResult {
    code: string | null;
    map: object | null;
    ast: object | null;
  }

  export function transform(code: string, options?: TransformOptions): TransformResult;
  export function transformFromAst(ast: object, code: string, options?: TransformOptions): TransformResult;
  export function registerPreset(name: string, preset: object): void;
  export function registerPlugin(name: string, plugin: object): void;
  export const availablePresets: Record<string, object>;
  export const availablePlugins: Record<string, object>;
}
