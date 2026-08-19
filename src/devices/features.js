// -----------------------------------------------------------------------------
// Shapes shared by the device types of this integration.
//
// Gladys stores `min` and `max` as NOT NULL columns of `t_device_feature`: a
// feature that leaves them out is refused with
// `HTTP 422 — t_device_feature.min cannot be null`, and — like an invalid
// `poll_frequency` — ONE refused feature rejects the WHOLE publish, so not a
// single device gets registered. The SDK types mark them optional; Gladys does
// not. Every feature built here therefore declares both, whether or not it
// carries a number.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

/**
 * A read-only text feature.
 *
 * Text is what this integration reports its states with: a Proxmox status is a
 * word (`running`, `stopped`, `OK`, `WARNINGS: 2`) or a whole error line, and
 * an on/off switch can hold none of them — it can only claim "not on", which
 * says nothing about a guest that is `paused` or a backup that failed on a full
 * datastore. Text states live in `last_value_string`, which Gladys keeps no
 * history for, hence `keep_history: false`.
 *
 * The bounds are the neutral `0`/`0`: a text feature has no numeric range, but
 * Gladys still requires the two columns.
 * @param {string} name - The feature name, as shown in Gladys.
 * @param {string} externalId - The feature external id.
 * @returns {object} The feature, in the standard Gladys format.
 */
export function textFeature(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  };
}
