import * as ts from "typescript";

export interface IGenerationProject {
    dir: string
    appStateName: string
    appSourcesDirectory: string
    tsOptions: ts.CompilerOptions
    writeFileCallback: (filename: string, b: Buffer) => void
}

export interface IGenerationProcess {
    run(): Promise<any>;
}