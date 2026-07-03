'use strict';

const fs   = require('fs');
const path = require('path');

const DATASETS_DIR = path.join(__dirname, 'datasets');

function loadAllTasks() {
  const allTasks = [];
  const seenIds  = new Set();

  const dirs = fs.readdirSync(DATASETS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const datasetKey of dirs) {
    const taskFile = path.join(DATASETS_DIR, datasetKey, 'tasks.json');
    if (!fs.existsSync(taskFile)) continue;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse tasks.json for dataset "${datasetKey}": ${err.message}`);
    }

    if (!Array.isArray(raw)) {
      throw new Error(`tasks.json for dataset "${datasetKey}" must be a JSON array`);
    }

    for (const task of raw) {
      if (typeof task.id !== 'number') {
        throw new Error(`Task in dataset "${datasetKey}" is missing a numeric "id" field`);
      }
      if (seenIds.has(task.id)) {
        throw new Error(`Duplicate task ID ${task.id} found in dataset "${datasetKey}"`);
      }
      seenIds.add(task.id);
      // Inject datasetKey from directory name if the task omits it.
      allTasks.push(task.datasetKey ? task : { ...task, datasetKey });
    }
  }

  return allTasks;
}

const tasks   = loadAllTasks();
const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));

function getAllTasks()                  { return tasks; }
function getTaskById(id)               { return taskMap[id] ?? null; }
function getTasksByDataset(datasetKey) { return tasks.filter(t => t.datasetKey === datasetKey); }

module.exports = { tasks, taskMap, getAllTasks, getTaskById, getTasksByDataset };
