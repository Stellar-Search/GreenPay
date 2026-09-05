import { renderHook } from "@testing-library/react";
import { useCountUp } from "../useCountUp";

describe("useCountUp", () => {
  let observeMock: jest.Mock;
  let disconnectMock: jest.Mock;
  let originalObserver: any;
  let rafSpy: jest.SpyInstance;
  let cafSpy: jest.SpyInstance;

  beforeEach(() => {
    observeMock = jest.fn();
    disconnectMock = jest.fn();
    
    originalObserver = global.IntersectionObserver;
  });

  afterEach(() => {
    global.IntersectionObserver = originalObserver;
    if (rafSpy) rafSpy.mockRestore();
    if (cafSpy) cafSpy.mockRestore();
  });

  it("cancels the animation and disconnects the observer on unmount", () => {
    let observerCallback: any;
    
    global.IntersectionObserver = class {
      constructor(cb: any) {
        observerCallback = cb;
      }
      observe = observeMock;
      disconnect = disconnectMock;
    } as any;

    rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 123);
    cafSpy = jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useCountUp(100, 1000));
    
    // Attach the callback ref
    const mockElement = document.createElement("div");
    result.current.elementRef(mockElement);
    
    // Expect observer to be attached
    expect(observeMock).toHaveBeenCalledWith(mockElement);
    
    // Trigger intersection
    observerCallback([{ isIntersecting: true }]);
    
    // Wait for the next tick for the effect to run
    // The state update (setIsVisible(true)) is synchronous in testing-library but 
    // the effect might run immediately. Let's just expect rafSpy.
    expect(rafSpy).toHaveBeenCalled();
    
    // Unmount
    unmount();
    
    expect(disconnectMock).toHaveBeenCalled();
    expect(cafSpy).toHaveBeenCalledWith(123);
  });
});
