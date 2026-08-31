const yaml = require('js-yaml');

const TASK_SECTIONS = ['pre_tasks', 'tasks', 'post_tasks', 'handlers'];

function invalid(error) {
  return { valid: false, error };
}

/**
 * Validate the YAML shape Ansible expects before a user playbook reaches disk.
 * This deliberately checks only stable playbook structure; module-specific
 * arguments remain Ansible's responsibility at execution time.
 */
function validatePlaybookContent(content) {
  const documents = [];
  try {
    yaml.loadAll(String(content || ''), document => documents.push(document));
  } catch (error) {
    const location = error?.mark
      ? ` at line ${Number(error.mark.line) + 1}, column ${Number(error.mark.column) + 1}`
      : '';
    return invalid(`Invalid YAML${location}: ${error?.reason || error?.message || 'parse failed'}`);
  }

  const populatedDocuments = documents.filter(document => document !== undefined && document !== null);
  if (populatedDocuments.length === 0) return invalid('Playbook must contain at least one play.');

  for (let documentIndex = 0; documentIndex < populatedDocuments.length; documentIndex += 1) {
    const document = populatedDocuments[documentIndex];
    const documentLabel = populatedDocuments.length > 1 ? `Document ${documentIndex + 1}` : 'Playbook';
    if (!Array.isArray(document)) return invalid(`${documentLabel} must be a YAML list of plays.`);
    if (document.length === 0) return invalid(`${documentLabel} must contain at least one play.`);

    for (let playIndex = 0; playIndex < document.length; playIndex += 1) {
      const play = document[playIndex];
      const location = `${documentLabel}, play ${playIndex + 1}`;
      if (!play || typeof play !== 'object' || Array.isArray(play)) {
        return invalid(`${location} must be a mapping.`);
      }

      if (!Object.prototype.hasOwnProperty.call(play, 'import_playbook')) {
        const hosts = play.hosts;
        const hostsPresent = Array.isArray(hosts)
          ? hosts.length > 0
          : typeof hosts === 'string' && hosts.trim().length > 0;
        if (!hostsPresent) return invalid(`${location} needs a non-empty "hosts" target.`);
      } else if (typeof play.import_playbook !== 'string' || !play.import_playbook.trim()) {
        return invalid(`${location} has an invalid "import_playbook" path.`);
      }

      for (const section of TASK_SECTIONS) {
        if (play[section] === undefined) continue;
        if (!Array.isArray(play[section])) return invalid(`${location}: "${section}" must be a list.`);
        for (let taskIndex = 0; taskIndex < play[section].length; taskIndex += 1) {
          const task = play[section][taskIndex];
          if (!task || typeof task !== 'object' || Array.isArray(task)) {
            return invalid(`${location}: ${section} item ${taskIndex + 1} must be a task mapping.`);
          }
        }
      }
    }
  }

  return { valid: true };
}

module.exports = { validatePlaybookContent };
