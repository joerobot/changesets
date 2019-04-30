/* eslint-disable no-await-in-loop */
import path from "path";
import fs from "fs-extra";

// import createRelease from "./createRelease";
// import createReleaseCommit from "./createReleaseCommit";
// import updateChangelog from "../changelog";

import { add, commit, getCommitThatAddsFile } from "../../utils/git";
import resolveConfig from "../../utils/resolveUserConfig";
import getPackageInfo from "../../utils/fromBolt/getPackageInfo";
import { versionOptions } from "../init/default-files/config";

import { removeFolders, removeEmptyFolders } from "../../utils/removeFolders";

async function bumpReleasedPackages(releaseObj, allPackages, config) {
  for (const release of releaseObj.releases) {
    const pkgDir = allPackages.find(pkg => pkg.name === release.name).dir;
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath));

    pkgJson.version = release.version;
    const pkgJsonStr = `${JSON.stringify(pkgJson, null, 2)}\n`;
    await fs.writeFile(pkgJsonPath, pkgJsonStr);
    if (config.commit) {
      await add(pkgJsonPath);
    }
  }
}

async function getNewFSChangesets(changesetBase) {
  removeEmptyFolders(changesetBase);
  if (!fs.existsSync(changesetBase)) {
    throw new Error("There is no .changeset directory in this project");
  }

  const dirs = fs.readdirSync(changesetBase);
  // this needs to support just not dealing with dirs that aren't set up properly
  const changesets = dirs
    .filter(file => fs.lstatSync(path.join(changesetBase, file)).isDirectory())
    .map(async changesetDir => {
      const summary = fs.readFileSync(
        path.join(changesetBase, changesetDir, "changes.md"),
        "utf-8"
      );
      const jsonPath = path.join(changesetBase, changesetDir, "changes.json");
      const json = await fs.readFile(jsonPath).then(JSON.parse);
      const addedCommit = await getCommitThatAddsFile(jsonPath);
      return { ...json, summary, commit: addedCommit };
    });
  return Promise.all(changesets);
}

async function run(opts) {
  let userConfig = await resolveConfig(opts);
  userConfig =
    userConfig && userConfig.versionOptions ? userConfig.versionOptions : {};
  const config = { ...versionOptions, ...userConfig, ...opts };
  const cwd = config.cwd || process.cwd();
  const noChangelogFlag = config.noChangelog;
  const allPackages = await getPackageInfo(cwd);
  const changesetBase = path.resolve(cwd, ".changeset");
  const unreleasedChangesets = await getNewFSChangesets(changesetBase);
  const releaseObj = createRelease(unreleasedChangesets, allPackages);
  const publishCommit = createReleaseCommit(releaseObj, config.skipCI);

  if (unreleasedChangesets.length === 0) {
    console.warn("No unreleased changesets found, exiting.");
    return;
  }

  console.log(publishCommit);

  await bumpReleasedPackages(releaseObj, allPackages, config);

  // Need to transform releases into a form for bolt to update dependencies
  const versionsToUpdate = releaseObj.releases.reduce(
    (cur, next) => ({
      ...cur,
      [next.name]: next.version
    }),
    {}
  );
  // update dependencies on those versions using bolt
  const pkgPaths = await bolt.updatePackageVersions(versionsToUpdate, {
    cwd
  });

  if (config.commit) {
    for (const pkgPath of pkgPaths) {
      await add(pkgPath);
    }
  }

  // This double negative is bad, but cleaner than the alternative
  if (!noChangelogFlag) {
    console.log("Updating changelogs...");
    // Now update the changelogs
    const changelogPaths = await updateChangelog(releaseObj, config);
    if (config.commit) {
      for (const changelogPath of changelogPaths) {
        await add(changelogPath);
      }
    }
  }

  console.log("Removing changesets...");

  // This should then reset the changesets folder to a blank state
  removeFolders(changesetBase);
  if (config.commit) {
    await add(changesetBase);

    console.log("Committing changes...");
    // TODO: Check if there are any unstaged changed before committing and throw
    // , as it means something went super-odd.
    await commit(publishCommit);
  } else {
    console.log(
      "All files have been updated. Review them and commit at your leisure"
    );
    console.warn(
      "If you alter version changes in package.jsons, make sure to run bolt before publishing to ensure the repo is in a valid state"
    );
  }
}

module.exports = run;
