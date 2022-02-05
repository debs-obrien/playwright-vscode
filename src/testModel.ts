/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Entry } from './oopReporter';
import { PlaywrightTest, ProjectListFilesReport, TestConfig } from './playwrightTest';
import { WorkspaceChange } from './workspaceObserver';
import * as vscodeTypes from './vscodeTypes';

export type TestFile = {
  project: TestProject;
  file: string;
  entries: Entry[] | undefined;
};

export type TestProject = {
  name: string;
  testDir: string;
  model: TestModel;
  isFirst: boolean;
  files: Map<string, TestFile>;
};

export class TestModel {
  readonly config: TestConfig;
  readonly projects = new Map<string, TestProject>();
  private _didUpdate: vscodeTypes.EventEmitter<void>;
  readonly onUpdated: vscodeTypes.Event<void>;
  readonly allFiles = new Set<string>();
  private _playwrightTest: PlaywrightTest;

  constructor(vscode: vscodeTypes.VSCode, playwrightTest: PlaywrightTest, workspaceFolder: string, configFile: string, cli: string) {
    this._playwrightTest = playwrightTest;
    this.config = { workspaceFolder, configFile, cli };
    this._didUpdate = new vscode.EventEmitter();
    this.onUpdated = this._didUpdate.event;
  }

  listFiles() {
    this._innerListFiles();
    this._didUpdate.fire();
  }

  private _innerListFiles() {
    const report = this._playwrightTest.listFiles(this.config);
    if (!report)
      return;

    const projectsToKeep = new Set<string>();
    for (const projectReport of report.projects) {
      projectsToKeep.add(projectReport.name);
      let project = this.projects.get(projectReport.name);
      if (!project)
        project = this._createProject(projectReport, projectReport === report.projects[0]);
      this._updateProject(project, projectReport);
    }

    for (const projectName of this.projects.keys()) {
      if (!projectsToKeep.has(projectName))
        this.projects.delete(projectName);
    }

    this._recalculateAllFiles();
  }

  private _createProject(projectReport: ProjectListFilesReport, isFirst: boolean): TestProject {
    const project: TestProject = {
      model: this,
      ...projectReport,
      isFirst,
      files: new Map(),
    };
    this.projects.set(project.name, project);
    return project;
  }

  private _updateProject(project: TestProject, projectReport: ProjectListFilesReport) {
    const filesToKeep = new Set<string>();
    for (const file of projectReport.files) {
      filesToKeep.add(file);
      const testFile = project.files.get(file);
      if (!testFile)
        this._createFile(project, file);
    }

    for (const file of project.files.keys()) {
      if (!filesToKeep.has(file))
        project.files.delete(file);
    }
  }

  private _createFile(project: TestProject, file: string): TestFile {
    const testFile: TestFile = {
      project,
      file,
      entries: undefined,
    };
    project.files.set(file, testFile);
    return testFile;
  }

  workspaceChanged(change: WorkspaceChange) {
    let modelChanged = false;
    if (change.deleted.size) {
      for (const project of this.projects.values()) {
        for (const file of change.deleted) {
          if (project.files.has(file)) {
            project.files.delete(file);
            modelChanged = true;
          }
        }
      }
    }

    if (change.created.size) {
      let hasMatchingFiles = false;
      for (const project of this.projects.values()) {
        for (const file of change.created) {
          if (file.startsWith(project.testDir))
            hasMatchingFiles = true;
        }
      }
      if (hasMatchingFiles) {
        this._innerListFiles();
        modelChanged = true;
      }
    }

    if (change.created.size || change.deleted.size)
      this._recalculateAllFiles();

    if (change.changed.size) {
      const filesToLoad = new Set<string>();
      for (const project of this.projects.values()) {
        for (const file of change.changed) {
          const testFile = project.files.get(file);
          if (!testFile || !testFile.entries)
            continue;
          filesToLoad.add(file);
        }
      }
      if (filesToLoad.size)
        this.listTests([...filesToLoad]);
    }
    if (modelChanged)
      this._didUpdate.fire();
  }

  async listTests(files: string[]) {
    const filesToLoad = files.filter(f => this.allFiles.has(f));
    if (!filesToLoad.length)
      return;
    const projectEntries = await this._playwrightTest.listTests(this.config, filesToLoad);
    this.updateProjects(projectEntries, filesToLoad);
  }

  updateProjects(projectEntries: Entry[], requestedFiles: string[]) {
    for (const projectEntry of projectEntries) {
      const project = this.projects.get(projectEntry.title);
      if (!project)
        continue;
      const filesToDelete = new Set(requestedFiles);
      for (const fileEntry of projectEntry.children || []) {
        filesToDelete.delete(fileEntry.location.file);
        const file = project.files.get(fileEntry.location.file);
        if (!file)
          continue;
        file.entries = fileEntry.children || [];
      }
      // We requested update for those, but got no entries.
      for (const file of filesToDelete) {
        const testFile = project.files.get(file);
        if (testFile)
          testFile.entries = [];
      }
    }
    this._didUpdate.fire();
  }

  updateFromRunningProject(project: TestProject, projects: Entry[]) {
    const projectEntry = projects.find(p => p.title === project.name);
    if (!projectEntry)
      return;

    const reportedFiles = new Set<string>();
    for (const fileEntry of projectEntry.children || []) {
      reportedFiles.add(fileEntry.location.file);
      if (!fileEntry.children)
        continue;
      let file = project.files.get(fileEntry.location.file);
      if (!file)
        file = this._createFile(project, fileEntry.location.file);
      // Only update if not yet discovered, we might be running focused
      // test that lacks other tests.
      if (!file.entries)
        file.entries = fileEntry.children;
    }

    for (const [file] of project.files) {
      if (!reportedFiles.has(file))
        project.files.delete(file);
    }
    this._didUpdate.fire();
  }

  testEntries(project: TestProject): Entry[] {
    const entries = new Map<string, Entry>();
    const visitEntry = (entry: Entry) => {
      if (entry.type === 'test')
        entries.set(entry.location.file + ':' + entry.location.line + ':' + entry.title, entry);
      (entry.children || []).forEach(visitEntry);
    };
    for (const file of project.files.values()) {
      if (file.entries)
        file.entries.forEach(visitEntry);
    }
    return [...entries.values()];
  }

  private _recalculateAllFiles() {
    this.allFiles.clear();
    for (const project of this.projects.values()) {
      for (const file of project.files.values())
        this.allFiles.add(file.file);
    }
  }
}
