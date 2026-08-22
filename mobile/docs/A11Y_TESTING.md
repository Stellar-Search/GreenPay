# Mobile Accessibility (a11y) Testing Checklist

To ensure the Stellar GreenPay mobile application is accessible to all users, please follow this checklist when testing core flows (such as browsing projects, completing a donation, and checking the donor profile).

## 1. Screen Reader Support
- [ ] **VoiceOver (iOS) / TalkBack (Android):** Core flows can be completed entirely with a screen reader.
- [ ] **Labels:** All interactive elements (buttons, inputs, icons) have descriptive accessibility labels (`accessibilityLabel` in React Native).
- [ ] **Role & State:** Elements correctly announce their role (e.g., button, link) and state (e.g., checked, disabled).
- [ ] **Focus Order:** Swiping left/right moves focus in a logical, top-to-bottom, left-to-right order.

## 2. Visual Accessibility
- [ ] **Color Contrast:** Text and important graphical objects have a contrast ratio of at least 4.5:1 against their background (3:1 for large text).
- [ ] **Dynamic Type:** The app supports system-level text size changes (Dynamic Type on iOS / Font Size on Android) without clipping or overlapping text.
- [ ] **Color Independence:** Information is not conveyed by color alone (e.g., error states use both color and icons/text).

## 3. Interaction & Navigation
- [ ] **Touch Targets:** All tap targets are at least 44x44 pt (iOS) or 48x48 dp (Android).
- [ ] **Keyboard Support:** The app can be navigated using an external hardware keyboard.
- [ ] **Gestures:** Core actions do not rely solely on complex gestures (e.g., multi-finger swipes); a simple alternative (like a button) is available.

## Core Flows to Test Manually
1. **Browse Projects:** Navigate the list of verified climate projects.
2. **Donation Flow:** Complete a simulated donation using testnet XLM.
3. **Donor Profile:** Check total XLM given and earned badges.

_Note: Consider implementing automated a11y checks using tools like `eslint-plugin-react-native-a11y` or Appium's accessibility checks in the future._
