import * as g from './generator';
import * as tsa from './tsAnalyzer';
import * as tsch from './tsCompilerHost';
import * as log from './logger';
import * as nameUnifier from './nameUnifier';
import * as pu from './pathUtils';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as pathPlatformDependent from 'path';

const path = pathPlatformDependent.posix; // This works everythere, just use forward slashes

var defaultLibFilename = path.join(path.dirname(require.resolve("typescript").replace(/\\/g, "/")), "lib.es6.d.ts");

export default (project: g.IGenerationProject, tsAnalyzer: tsa.ITsAnalyzer, logger: log.ILogger, applyRecurse: boolean = false, rootStateKey: string = null): g.IGenerationProcess => {
    return {
        run: () => runBase(false, project, tsAnalyzer, logger, rootStateKey),
        runRecurse: () => runBase(true, project, tsAnalyzer, logger, rootStateKey)
    }
}

function runBase(applyRecurse: boolean, project: g.IGenerationProject, tsAnalyzer: tsa.ITsAnalyzer, logger: log.ILogger, rootStateKey: string): Promise<any> {
    return new Promise((f, r) => {
        const writeCallback = (fn, c) => project.writeFileCallback(fn, new Buffer(c, 'utf-8'));
        g.loadSourceFiles(project, tsAnalyzer, logger)
            .then(p => {
                let rootBaseDir = path.dirname(p.stateFilePath);
                let relativeDir = project.relativePath ? path.join(path.dirname(p.stateFilePath), project.relativePath) : rootBaseDir;
                try {
                    let filePath = path.join(path.dirname(p.stateFilePath), path.basename(p.stateFilePath));
                    try {
                        writeBuilders(filePath, p.data, project.appStateName, project.relativePath, writeCallback, rootStateKey);
                    } catch (e) {
                        logger.error('Error on cursors writing.', e);
                    }
                } catch (e) {
                    logger.error('Error on cursors writing.', e);
                }

                function writeBuilders(stateFilePath: string, data: tsa.IStateSourceData, currentStateName: string, relativePath: string, writeCallback: (filePath: string, content: string) => void, parentStateKey: string = null) {
                    let mainState = g.resolveState(data.states, currentStateName);
                    if (!mainState)
                        return;
                    const bobfluxPrefix = g.resolveBobfluxPrefix(mainState);
                    let stateAlias = g.createUnusedAlias(g.stateImportKey, data.imports);
                    let buildersFilePath = pu.createBuildersFilePath(rootBaseDir, relativeDir, stateFilePath);
                    let rootRelativePath = pu.resolveRelatioveStateFilePath(path.dirname(buildersFilePath.replace(/\\/g, "/")), path.dirname(stateFilePath));

                    function createFieldsContent(state: tsa.IStateData, prefix: string = null): string {
                        logger.info('Fields proccessing started for: ', state.typeName);
                        let nexts: INextIteration[] = [];
                        let name = `${nameUnifier.removeIfacePrefix(state.typeName)}Builder`;
                        let stateName = `${stateAlias}.${state.typeName}`;
                        let content = createBuilderHeader(name, stateName, stateAlias)
                        content += state.fields.map(f => {
                            logger.info('Field proccessing started for: ', f.name);
                            let key = g.composeCursorKey(parentStateKey, prefix, f.name);
                            let fieldType = f.isArray ? `${f.type}[]` : f.type;
                            if (applyRecurse && g.isExternalState(fieldType)) {
                                let typeParts = fieldType.split('.');
                                let innerFilePath = path.join(path.dirname(stateFilePath), data.imports.filter(i => i.prefix === typeParts[0])[0].relativePath + '.ts');
                                let innerSourceFile = g.resolveSourceFile(p.sourceFiles, innerFilePath);
                                if (innerSourceFile) {
                                    let innerRelativePath = pu.resolveRelatioveStateFilePath(path.dirname(innerSourceFile.path), path.dirname(buildersFilePath.replace(/\\/g, "/")) + '/').replace(/\\/g, "/");
                                    logger.info('Called write builders for nested state: ', innerFilePath);
                                    writeBuilders(innerFilePath, tsAnalyzer.getSourceData(innerSourceFile, p.typeChecker), typeParts[1], innerRelativePath, writeCallback, key);
                                }
                            }
                            let states = data.states.filter(s => s.typeName === f.type);
                            if (states.length > 0)
                                fieldType = `${stateAlias}.${fieldType}`;
                            if (states.length > 0)
                                nexts.push({ state: states[0], prefix: key });
                            if (states.length > 1)
                                throw 'Two states with same name could not be parsed. It\'s compilation error.';
                            logger.info('Field proccessing ended for: ', f.name);
                            return createWithForField(name, f.name, fieldType);
                        }).join('\n');
                        content += createBuilderFooter(stateName, currentStateName === state.typeName ? bobfluxPrefix : null);
                        logger.info('Fields proccessing ended for: ', state.typeName);
                        return content + (nexts.length > 0 ? '\n' : '') + nexts.map(n => createFieldsContent(n.state, n.prefix)).join('\n');
                    }

                    logger.info('Generating has been started for: ', stateFilePath);
                    writeCallback(
                        buildersFilePath,
                        g.createFullImports(
                            stateAlias,
                            !relativePath
                                ? './' + data.fileName
                                : path.join(rootRelativePath.replace(/\\/g, "/"), data.fileName),
                            !relativePath
                                ? data.imports
                                : data.imports.map(i => <tsa.IImportData>{
                                    prefix: i.prefix,
                                    fullPath: i.fullPath,
                                    relativePath: path.join(rootRelativePath.replace(/\\/g, "/"), i.relativePath)
                                })
                        )
                        + createFieldsContent(mainState)
                    );
                    logger.info('Generating ended for: ', stateFilePath);
                }
                f();
            })
            .catch(e => r(e));
    })
}

type PrefixMap = { [stateName: string]: string };
interface INextIteration {
    state: tsa.IStateData
    prefix: string
}

function resolveRelativePath(filePath: string, projectRelativePath: string, parentRelativePath: string = './'): string {
    let relativePath = path.join(path.dirname(filePath), projectRelativePath);
    return path.relative(relativePath, path.dirname(filePath));
}

function createBuilderHeader(builderName: string, stateName: string, stateAlias: string) {
    return `export class ${builderName} {
    private state: ${stateName} = ${stateAlias}.default();

`
}

function createWithForField(builderName: string, fieldName: string, fieldType: string): string {
    return `    public ${nameUnifier.getStatePrefixFromKeyPrefix('with', fieldName)}(${fieldName}: ${fieldType}): ${builderName} {
        this.state.${fieldName} = ${fieldName};
        return this;
    };
`
}

function createBuilderFooter(stateTypeName: string, bobfluxPrefix = null): string {
    let content = `
    public build(): ${stateTypeName} {
`;
    if (bobfluxPrefix)
        content +=
            `        ${bobfluxPrefix}.bootstrap(this.state);
`
    content +=
        `        return this.state;
    }
}
`
    return content;
}
