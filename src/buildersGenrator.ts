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

export default (project: g.IGenerationProject, tsAnalyzer: tsa.ITsAnalyzer, logger: log.ILogger, rootStateKey: string = null): g.IGenerationProcess => {
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

                function writeBuilders(stateFilePath: string, data: tsa.IStateSourceData, currentStateName: string, relativePath: string,
                    writeCallback: (filePath: string, content: string) => void, parentStateKey: string) {
                    let mainState = g.resolveState(data.states, currentStateName);
                    if (!mainState)
                        return;
                    const bobfluxPrefix = g.resolveBobfluxPrefix(mainState);
                    const bobfluxImport = data.sourceDeps[bobfluxPrefix];
                    let imports: { [fullPath: string]: tsa.IImportData } = bobfluxImport ? { [bobfluxImport.fullPath]: bobfluxImport } : {};
                    let stateAlias = g.createUnusedAlias(g.stateImportKey, data.imports);
                    let buildersFilePath = pu.createBuildersFilePath(rootBaseDir, relativeDir, stateFilePath).replace(/\\/g, "/");
                    let rootRelativePath = pu.resolveRelatioveStateFilePath(path.dirname(buildersFilePath), path.dirname(stateFilePath));
                    let generatedBuilders: string[] = [];

                    function createFieldsContent(state: tsa.IStateData, prefix: string = null): string {
                        logger.info('Fields proccessing started for: ', state.typeName);
                        let nexts: INextIteration[] = [];
                        let builderName = `${nameUnifier.removeIfacePrefix(state.typeName)}Builder`;
                        let stateTypeName = `${stateAlias}.${state.typeName}`;
                        if (generatedBuilders.filter(g => g === stateTypeName).length > 0)
                            return '';

                        generatedBuilders.push(stateTypeName);
                        let content = createBuilderHeader(builderName, stateTypeName, state.typeName, stateAlias);
                        content += state.fields.map(f => {
                            logger.info('Field proccessing started for: ', f.name);
                            let key = g.composeCursorKey(prefix, f.name);
                            let withContent = '';
                            f.type.forEach(t => {
                                if (applyRecurse && g.isExternalState(t.name, data)) {
                                    const alias = g.getExternalAlias(t.name, data, imports);
                                    let innerFilePath = path.join(path.dirname(stateFilePath), alias.relativePath + '.ts');
                                    let innerSourceFile = g.resolveSourceFile(p.sourceFiles, innerFilePath);
                                    if (innerSourceFile) {
                                        let innerRelativePath = pu.resolveRelatioveStateFilePath(path.dirname(innerSourceFile.path), path.dirname(buildersFilePath) + '/').replace(/\\/g, "/");
                                        logger.info('Called write builders for nested state: ', innerFilePath);
                                        writeBuilders(innerFilePath, tsAnalyzer.getSourceData(innerSourceFile, p.typeChecker), alias.sourceType, innerRelativePath, writeCallback, key);
                                    }
                                }
                                let states = data.states.filter(s => s.typeName === t.name);
                                let fieldBuilder: string = null;
                                if (states.length > 1)
                                    throw 'Two states with same name could not be parsed. It\'s compilation error.';
                                logger.info('Field proccessing ended for: ', f.name);
                                if (states.length > 0 && !t.arguments)
                                    nexts.push({ state: states[0], prefix: key });

                                if (states.length > 0 && f.type.length === 1 && !t.indexer && !t.arguments) {
                                    let builderImport = g.isExternalState(t.name, data) ? `${stateAlias}Builders.` : '';
                                    withContent = createWithForFieldAndBuilder(builderName, f.name, `${stateAlias}.${t.name}`, `${nameUnifier.removeIfacePrefix(t.name)}Builder`, builderImport, t.isArray);
                                }
                            });
                            return withContent
                                ? withContent
                                : createWithForField(
                                    builderName,
                                    f.name,
                                    g.getFullType(f.type, data, stateAlias, imports)
                                );
                        }).join('\n');
                        content += createBuilderFooter(stateTypeName, bobfluxPrefix, prefix);
                        content += createIsBuilder(builderName, stateTypeName);
                        logger.info('Fields proccessing ended for: ', state.typeName);
                        return content + (nexts.length > 0 ? '\n' : '') + nexts.map(n => createFieldsContent(n.state, n.prefix)).filter(b => b).join('\n');
                    }

                    logger.info('Generating has been started for: ', stateFilePath);
                    const fieldsContent = createFieldsContent(mainState, parentStateKey);
                    writeCallback(
                        buildersFilePath,
                        g.createAutogeneratedHeader(project.version)
                        + g.createFullImports(
                            stateAlias,
                            !relativePath
                                ? './' + data.fileName
                                : path.join(rootRelativePath.replace(/\\/g, "/"), data.fileName),
                            Object.keys(imports).map(key =>
                                relativePath && imports[key].relativePath.startsWith('.')
                                    ? Object.assign({}, imports[key], {
                                        relativePath: path.join(rootRelativePath.replace(/\\/g, "/"), imports[key].relativePath)
                                    })
                                    : imports[key])
                        )
                        + fieldsContent
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

function createBuilderHeader(builderName: string, stateName: string, stateTypeName: string, stateAlias: string) {
    return `export class ${builderName} {
    protected state: ${stateName} = ${stateAlias}.createDefault${nameUnifier.removeIfacePrefix(stateTypeName)}();

`
}

function createWithForFieldAndBuilder(builderName: string, fieldName: string, fieldType: string, fieldBuilder: string, fieldBuilderPrefix: string, isArray: boolean): string {
    return isArray
        ? `    public ${nameUnifier.getStatePrefixFromKeyPrefix('with', fieldName)}(...${fieldName}: (${fieldType} | ${fieldBuilderPrefix}${fieldBuilder})[]): ${builderName} {
        this.state.${fieldName} = ${fieldName}.map(i => ${fieldBuilderPrefix}is${fieldBuilder}(i) ? i.build() : i);
        return this;
    };
`
        : `    public ${nameUnifier.getStatePrefixFromKeyPrefix('with', fieldName)}(${fieldName}: ${fieldType} | ${fieldBuilder}): ${builderName} {
        this.state.${fieldName} = ${fieldBuilderPrefix}is${fieldBuilder}(${fieldName}) ? ${fieldName}.build() : ${fieldName};
        return this;
    };
`
}

function createWithForField(builderName: string, fieldName: string, fieldType: string): string {
    return `    public ${nameUnifier.getStatePrefixFromKeyPrefix('with', fieldName)}(${fieldName}: ${fieldType}): ${builderName} {
        this.state.${fieldName} = ${fieldName};
        return this;
    };
`
}

function createBuilderFooter(stateTypeName: string, bobfluxPrefix: string, rootStateKey: string): string {
    return `
    public build(): ${stateTypeName} {
        return this.state;
    }

    public buildToStore(): ${stateTypeName} {
        ${bobfluxPrefix}.bootstrap(${rootStateKey ? nameUnifier.createDomString(rootStateKey, 'this.state') : 'this.state'});
        return this.state;
    }
}
`
}

function createIsBuilder(builderName: string, stateTypeName: string): string {
    return `
export function is${builderName}(obj: ${stateTypeName} | ${builderName}): obj is ${builderName} {
    return 'build' in obj;
}
`;
}
