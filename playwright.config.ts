import { defineConfig, devices } from "@playwright/test";
const external = process.env.PLAYWRIGHT_BASE_URL;
// Chrome's fake-device switches and permission grants are not WebKit APIs.
const chromiumCapture = {
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
};
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: external || "http://127.0.0.1:4173/jove-english-os/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: "**/webkit.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        ...chromiumCapture,
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      testIgnore: "**/webkit.spec.ts",
      use: { ...devices["Pixel 7"], ...chromiumCapture, defaultBrowserType: "chromium" },
    },
    {
      name: "webkit-desktop",
      testMatch: ["**/webkit.spec.ts", "**/longitudinal.spec.ts", "**/external-study.spec.ts"],
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 1000 } },
    },
    {
      // Emulated viewport/touch/user agent, not an actual iPhone or Safari app.
      name: "webkit-mobile",
      testMatch: ["**/webkit.spec.ts", "**/longitudinal.spec.ts", "**/external-study.spec.ts"],
      use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" },
    },
    {
      // Separately verify the generated-stream fixture with a native recorder.
      // These are additional tests, not substitutes for the WebKit media gate.
      name: "chromium-media",
      testMatch: "**/webkit.spec.ts",
      grep: /real browser capture|device rejection|built-in WAV/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-pcm",
      testMatch: "**/webkit.spec.ts",
      grep: /real browser capture|device rejection/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-mobile-ux",
      testMatch: "**/webkit.spec.ts",
      grep: /all nine routes|keyboard skip navigation|mobile touch|safe-area/,
      use: { ...devices["Pixel 7"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: "npm run preview",
        url: "http://127.0.0.1:4173/jove-english-os/",
        reuseExistingServer: !process.env.CI,
        timeout: 30000,
      },
});
