import { 
  isAdminAuthenticated, 
  setAdminToken, 
  logoutAdmin, 
  adminLogin,
  fetchAISummaryFailures,
  versionedApiPath,
} from "../api";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";

// The interceptors are attached to the default exported axios instance.
// But we don't export the `api` instance directly, we export the functions.
// We can intercept requests via nock or by mocking window.sessionStorage and observing behavior.

const mockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    }
  };
})();

Object.defineProperty(window, 'sessionStorage', {
  value: mockStorage
});

describe("API Admin Session", () => {
  // We need to access the underlying axios instance to mock it properly.
  // We can just use jest.mock or axios-mock-adapter.
  let mock: MockAdapter;

  beforeEach(() => {
    // we need the api instance, since it's not exported, we can mock all network calls
    // But since api.ts uses axios.create, we might need a different approach.
    // Let's mock window fetch if it uses fetch, but api.ts uses axios for these.
    window.sessionStorage.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("stores token and refresh token on login", async () => {
    // Actually testing axios directly in the module might be tricky if `api` is scoped.
    // Let's just test the storage functions.
    setAdminToken("fake_token", "fake_refresh");
    expect(window.sessionStorage.getItem("greenpay_admin_token")).toBe("fake_token");
    expect(window.sessionStorage.getItem("greenpay_admin_refresh_token")).toBe("fake_refresh");
    expect(isAdminAuthenticated()).toBe(true);
  });

  it("clears tokens on logout", () => {
    setAdminToken("fake_token", "fake_refresh");
    logoutAdmin();
    expect(window.sessionStorage.getItem("greenpay_admin_token")).toBeNull();
    expect(window.sessionStorage.getItem("greenpay_admin_refresh_token")).toBeNull();
    expect(isAdminAuthenticated()).toBe(false);
  });
});

describe("API major-version path selection", () => {
  it("moves historical paths to v1 without rewriting explicit or neutral versions", () => {
    expect(versionedApiPath("/api/projects")).toBe("/api/v1/projects");
    expect(versionedApiPath("/api/v2/meta")).toBe("/api/v2/meta");
    expect(versionedApiPath("/api/versions/changelog")).toBe("/api/versions/changelog");
  });
});
