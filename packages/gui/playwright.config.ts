import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  ...(process.env.CI ? { workers: 2 } : {}),
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "bun run --cwd ../core build && bun run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
})
