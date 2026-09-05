import { test, expect } from "@playwright/test";

const arabicProject = {
  id: "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
  name: "مبادرة إعادة تشجير الأمازون",
  description: "نزرع الأشجار المحلية ونستعيد الغابات المتدهورة لحماية المناخ والتنوع الحيوي.",
  category: "إعادة التشجير",
  sourceCategory: "Reforestation",
  location: "البرازيل، أمريكا الجنوبية",
  walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  goalXLM: "50000",
  raisedXLM: "18420",
  donorCount: 147,
  co2OffsetKg: 245000,
  status: "active",
  verified: true,
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sourceLanguage: "en",
  contentLanguage: "ar",
  contentDirection: "rtl",
  requestedLanguage: "ar",
  usedFallback: false,
  machineTranslated: true,
};

test("Arabic project copy stays RTL inside the existing card", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("greenpay-locale", "ar"));
  await page.route("**/api/v1/**", (route) => route.fulfill({
    json: { success: true, data: [] },
  }));
  await page.route("**/api/v1/projects**", (route) => route.fulfill({
    json: { success: true, data: [arabicProject] },
  }));

  await page.goto("/projects");
  const card = page.getByTestId("project-card");
  await expect(card).toBeVisible();
  const content = card.getByRole("heading", { name: arabicProject.name }).locator("..");
  await expect(content).toHaveAttribute("lang", "ar");
  await expect(content).toHaveAttribute("dir", "rtl");
  await expect(card).toHaveScreenshot("arabic-project-card.png", {
    animations: "disabled",
    // Arabic glyph rasterization varies slightly between developer and CI Linux images.
    maxDiffPixelRatio: 0.05,
  });
});
