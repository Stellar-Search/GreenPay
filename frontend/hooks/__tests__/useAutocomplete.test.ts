import { renderHook, act } from "@testing-library/react";
import { useAutocomplete } from "../useAutocomplete";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useAutocomplete", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("discards a stale response that resolves after a newer query's response", async () => {
    const olderQuery = deferred<string[]>();
    const newerQuery = deferred<string[]>();
    const fetcher = jest.fn((query: string) => {
      if (query === "fore") return olderQuery.promise;
      if (query === "forest") return newerQuery.promise;
      throw new Error(`unexpected query: ${query}`);
    });

    const { result } = renderHook(() => useAutocomplete(fetcher, 300));

    act(() => {
      result.current.setQuery("fore");
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(fetcher).toHaveBeenCalledWith("fore");

    act(() => {
      result.current.setQuery("forest");
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(fetcher).toHaveBeenCalledWith("forest");

    // Newer query's response arrives first...
    await act(async () => {
      newerQuery.resolve(["Forest Restoration"]);
      await Promise.resolve();
    });
    expect(result.current.results).toEqual(["Forest Restoration"]);

    // ...then the older, superseded query's response resolves late.
    await act(async () => {
      olderQuery.resolve(["Foreshore Cleanup"]);
      await Promise.resolve();
    });

    // The stale response must not overwrite the newer results.
    expect(result.current.results).toEqual(["Forest Restoration"]);
  });

  it("still debounces fetches by the configured delay", () => {
    const fetcher = jest.fn(() => new Promise<string[]>(() => {}));
    const { result } = renderHook(() => useAutocomplete(fetcher, 300));

    act(() => {
      result.current.setQuery("re");
    });
    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(fetcher).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
