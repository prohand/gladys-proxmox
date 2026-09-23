// -----------------------------------------------------------------------------
// The keys of the Gladys 5.1 capabilities: dashboard widgets, scene triggers
// and scene actions.
//
// Each of them is declared in the manifest and stored by Gladys — in the
// dashboards, in the scenes — so a published key is FOREVER: renaming one is
// removing it for every dashboard and every scene that uses it. They live here,
// once, so the code and `test/manifest.test.js` read the same list.
// -----------------------------------------------------------------------------

// The dashboard widgets (manifest `widgets`).
export const WIDGET = {
  BACKUPS: 'backups',
  GUESTS: 'guests',
  NODE: 'node',
};

// The button every widget carries (a `button` component `action`).
export const WIDGET_ACTION = {
  REFRESH: 'refresh',
};

// What HAPPENED, fired through `publishSceneEvent()` (manifest `scene_triggers`).
export const SCENE_TRIGGER = {
  BACKUP_FINISHED: 'backup_finished',
  GUEST_STATUS_CHANGED: 'guest_status_changed',
  DISK_FAILED: 'disk_failed',
};

// What a scene can ask for (manifest `scene_actions`). All of them READ: this
// integration never starts, stops nor migrates anything.
export const SCENE_ACTION = {
  REFRESH: 'refresh',
  GET_BACKUP_STATUS: 'get_backup_status',
  GET_SMART_STATUS: 'get_smart_status',
  GET_GUEST_STATUS: 'get_guest_status',
};

// The value of the `result` filter of the "Backup finished" trigger.
export const BACKUP_RESULT = {
  OK: 'ok',
  FAILED: 'failed',
};
