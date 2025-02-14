/***************************************************************************************************
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 **************************************************************************************************/

import * as core from "@actions/core";
import * as io from "@actions/io";
import * as path from "path";
import { Inputs, Outputs } from "./generated/inputs-outputs";
import { BuildahCli, BuildahConfigSettings } from "./buildah";
import {
    getArch, getContainerfiles, getInputList, splitByNewline,
} from "./utils";

export async function run(): Promise<void> {
    if (process.env.RUNNER_OS !== "Linux") {
        throw new Error("buildah, and therefore this action, only works on Linux. Please use a Linux runner.");
    }

    // get buildah cli
    const buildahPath = await io.which("buildah", true);
    const cli: BuildahCli = new BuildahCli(buildahPath);

    // print buildah version
    await cli.execute([ "version" ], { group: true });

    // Check if fuse-overlayfs exists and find the storage driver
    await cli.setStorageOptsEnv();

    const DEFAULT_TAG = "latest";
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const containerFiles = getContainerfiles();
    const image = core.getInput(Inputs.IMAGE, { required: true });
    const tags = core.getInput(Inputs.TAGS);
    const tagsList: string[] = tags.split(" ");

    // info message if user doesn't provides any tag
    if (tagsList.length === 0) {
        core.info(`Input "${Inputs.TAGS}" is not provided, using default tag "${DEFAULT_TAG}"`);
        tagsList.push(DEFAULT_TAG);
    }
    const newImage = `${image}:${tagsList[0]}`;
    const useOCI = core.getInput(Inputs.OCI) === "true";

    const arch = getArch();

    if (containerFiles.length !== 0) {
        await doBuildUsingContainerFiles(cli, newImage, workspace, containerFiles, useOCI, arch);
    }
    else {
        await doBuildFromScratch(cli, newImage, useOCI, arch);
    }

    if (tagsList.length > 1) {
        await cli.tag(image, tagsList);
    }
    core.setOutput(Outputs.IMAGE, image);
    core.setOutput(Outputs.TAGS, tags);
    core.setOutput(Outputs.IMAGE_WITH_TAG, `${image}:${tagsList[0]}`);
}

async function doBuildUsingContainerFiles(
    cli: BuildahCli, newImage: string, workspace: string, containerFiles: string[], useOCI: boolean, arch: string
): Promise<void> {
    if (containerFiles.length === 1) {
        core.info(`Performing build from Containerfile`);
    }
    else {
        core.info(`Performing build from ${containerFiles.length} Containerfiles`);
    }

    const context = path.join(workspace, core.getInput(Inputs.CONTEXT));
    const buildArgs = getInputList(Inputs.BUILD_ARGS);
    const containerFileAbsPaths = containerFiles.map((file) => path.join(workspace, file));
    const layers = core.getInput(Inputs.LAYERS);

    const inputExtraArgsStr = core.getInput(Inputs.EXTRA_ARGS);
    let buildahBudExtraArgs: string[] = [];
    if (inputExtraArgsStr) {
        // transform the array of lines into an array of arguments
        // by splitting over lines, then over spaces, then trimming.
        const lines = splitByNewline(inputExtraArgsStr);
        buildahBudExtraArgs = lines.flatMap((line) => line.split(" ")).map((arg) => arg.trim());
    }
    await cli.buildUsingDocker(
        newImage, context, containerFileAbsPaths, buildArgs, useOCI, arch, layers, buildahBudExtraArgs
    );
}

async function doBuildFromScratch(
    cli: BuildahCli, newImage: string, useOCI: boolean, arch: string
): Promise<void> {
    core.info(`Performing build from scratch`);

    const baseImage = core.getInput(Inputs.BASE_IMAGE, { required: true });
    const content = getInputList(Inputs.CONTENT);
    const entrypoint = getInputList(Inputs.ENTRYPOINT);
    const port = core.getInput(Inputs.PORT);
    const workingDir = core.getInput(Inputs.WORKDIR);
    const envs = getInputList(Inputs.ENVS);

    const container = await cli.from(baseImage);
    const containerId = container.output.replace("\n", "");

    const newImageConfig: BuildahConfigSettings = {
        entrypoint,
        port,
        workingdir: workingDir,
        envs,
        arch,
    };
    await cli.config(containerId, newImageConfig);
    await cli.copy(containerId, content);
    await cli.commit(containerId, newImage, useOCI);
}

run().catch(core.setFailed);
