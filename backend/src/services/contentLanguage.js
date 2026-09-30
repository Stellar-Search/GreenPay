"use strict";

const SUPPORTED_CONTENT_LANGUAGES = Object.freeze(["en", "es", "ar"]);
const RTL_CONTENT_LANGUAGES = new Set(["ar"]);
const TRANSLATION_STATUSES = Object.freeze(["pending", "approved", "rejected"]);

function normalizeContentLanguage(value, { optional = true } = {}) {
  if (value === undefined || value === null || value === "") {
    return optional ? null : "en";
  }
  if (typeof value !== "string") return null;
  const language = value.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_CONTENT_LANGUAGES.includes(language) ? language : null;
}

function requireContentLanguage(value) {
  const language = normalizeContentLanguage(value);
  if (!language) {
    const error = new Error(`language must be one of: ${SUPPORTED_CONTENT_LANGUAGES.join(", ")}`);
    error.status = 400;
    error.code = "CONTENT_LANGUAGE_INVALID";
    throw error;
  }
  return language;
}

function contentDirection(language) {
  return RTL_CONTENT_LANGUAGES.has(language) ? "rtl" : "ltr";
}

function projectLocalizationSelect(languageParam) {
  if (!languageParam) return { join: "", columns: "" };
  return {
    join: ` LEFT JOIN project_translations content_translation
      ON content_translation.project_id = p.id
     AND content_translation.language = ${languageParam}
     AND content_translation.moderation_status = 'approved'`,
    columns: `,
      content_translation.name AS localized_name,
      content_translation.description AS localized_description,
      content_translation.category AS localized_category,
      content_translation.location AS localized_location,
      content_translation.language AS localized_language,
      content_translation.machine_translated AS localized_machine_translated`,
  };
}

function updateLocalizationSelect(languageParam) {
  if (!languageParam) return { join: "", columns: "" };
  return {
    join: ` LEFT JOIN project_update_translations content_translation
      ON content_translation.update_id = u.id
     AND content_translation.language = ${languageParam}
     AND content_translation.moderation_status = 'approved'`,
    columns: `,
      content_translation.title AS localized_title,
      content_translation.body AS localized_body,
      content_translation.language AS localized_language,
      content_translation.machine_translated AS localized_machine_translated`,
  };
}

function translationMetadata(row) {
  const sourceLanguage = row.source_language || "en";
  const contentLanguage = row.localized_language || sourceLanguage;
  return {
    sourceLanguage,
    contentLanguage,
    contentDirection: contentDirection(contentLanguage),
    requestedLanguage: row.requested_language || null,
    usedFallback: Boolean(row.requested_language && contentLanguage !== row.requested_language),
    machineTranslated: Boolean(row.localized_language && row.localized_machine_translated),
  };
}

module.exports = {
  SUPPORTED_CONTENT_LANGUAGES,
  TRANSLATION_STATUSES,
  normalizeContentLanguage,
  requireContentLanguage,
  contentDirection,
  projectLocalizationSelect,
  updateLocalizationSelect,
  translationMetadata,
};
