'use strict';

const { LIMITS, TOOL_DEFINITIONS } = require('./constants.cjs');

const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function toolDefinition(name) {
  return TOOLS_BY_NAME.get(String(name || '')) || null;
}

function parseToolArguments(name, rawArguments) {
  const definition = toolDefinition(name);
  if (!definition) throw new Error('That action is unavailable.');

  let args;
  if (rawArguments === undefined || rawArguments === null || rawArguments === '') {
    args = {};
  } else if (typeof rawArguments === 'string') {
    if (rawArguments.length > LIMITS.MAX_TOOL_ARGUMENT_CHARS) {
      throw new Error('The model sent tool arguments that are too large.');
    }
    try {
      args = JSON.parse(rawArguments);
    } catch {
      throw new Error('The model sent invalid tool arguments.');
    }
  } else if (typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    args = rawArguments;
  } else {
    throw new Error('The model sent invalid tool arguments.');
  }

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('The model sent invalid tool arguments.');
  }

  const expected = Object.keys(definition.parameters);
  const provided = Object.keys(args);
  const unknown = provided.filter((key) => !expected.includes(key));
  if (unknown.length) {
    throw new Error(`The model sent unsupported arguments for ${name}: ${unknown.join(', ')}.`);
  }
  for (const key of expected) {
    if (typeof args[key] !== 'string') throw new Error(`The ${key} argument for ${name} must be text.`);
    if (args[key].length > LIMITS.MAX_TOOL_ARGUMENT_CHARS) {
      throw new Error(`The ${key} argument for ${name} is too large.`);
    }
  }
  return args;
}

module.exports = {
  toolDefinition,
  parseToolArguments
};
