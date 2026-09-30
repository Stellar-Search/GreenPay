import { useI18n } from "@/lib/i18n";

interface LocalizedContent {
  sourceLanguage?: "en" | "es" | "ar";
  contentLanguage?: "en" | "es" | "ar";
  requestedLanguage?: "en" | "es" | "ar" | null;
  usedFallback?: boolean;
  machineTranslated?: boolean;
}

export default function ContentLanguageNotice({ content }: { content: LocalizedContent }) {
  const { t, localeTag } = useI18n();
  const language = content.contentLanguage || content.sourceLanguage || "en";
  let languageName = language.toUpperCase();
  try {
    languageName = new Intl.DisplayNames([localeTag], { type: "language" }).of(language) || languageName;
  } catch {
    // The language code remains an unambiguous label on older browsers.
  }

  if (content.machineTranslated) {
    return (
      <p data-testid="content-language-notice" className="text-xs rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 font-body">
        {t("project.machineTranslatedContent", { language: languageName })}
      </p>
    );
  }
  if (content.usedFallback) {
    return (
      <p data-testid="content-language-notice" className="text-xs rounded-lg border border-forest-200 bg-forest-50 px-3 py-2 text-forest-800 font-body">
        {t("project.fallbackContent", { language: languageName })}
      </p>
    );
  }
  if (content.requestedLanguage || language !== "en") {
    return (
      <p data-testid="content-language-notice" className="text-xs text-[#547454] font-body">
        {t("project.contentLanguage", { language: languageName })}
      </p>
    );
  }
  return null;
}
