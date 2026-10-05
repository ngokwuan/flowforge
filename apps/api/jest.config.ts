import { createDefaultEsmPreset, type JestConfigWithTsJest } from 'ts-jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import ts from 'typescript';

// Path aliases (e.g. the ones added by `nest g library`) live in tsconfig.json,
// so they are read from there instead of being duplicated here.
const { config: tsconfig } = ts.readConfigFile(
  './tsconfig.json',
  ts.sys.readFile,
);
const paths = tsconfig?.compilerOptions?.paths ?? {};

// @nestjs/* v12 packages ship as pure ESM ("type": "module"), so Jest must run
// in ESM mode via --experimental-vm-modules.  createDefaultEsmPreset wires up
// extensionsToTreatAsEsm, the ts-jest ESM transformer, and the correct preset.
const config: JestConfigWithTsJest = {
  ...createDefaultEsmPreset({
    // ts-jest's transpileModule ignores "module: nodenext" and falls back to CJS;
    // overriding to ESNext forces it to emit real ESM that Jest's vm-modules can load.
    tsconfig: {
      ...tsconfig?.compilerOptions,
      module: 'ESNext',
      moduleResolution: 'bundler',
    },
  }),
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    // nodenext requires explicit .js extensions in imports; remap them to .ts
    '^(\\.{1,2}/.*)\\.js$': '$1',
    ...pathsToModuleNameMapper(paths, { prefix: '<rootDir>/' }),
  },
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    'libs/**/*.(t|j)s',
    'apps/**/*.(t|j)s',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
