import React from "react";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../components/ErrorBoundary";

const ThrowingChild = () => {
  throw new Error("Test render failure");
};

describe("ErrorBoundary", () => {
  // Prevent console error spam during expected throw
  const originalError = console.error;
  beforeAll(() => {
    console.error = jest.fn();
  });
  afterAll(() => {
    console.error = originalError;
  });

  it("renders custom fallback UI when a child component throws", () => {
    render(
      <ErrorBoundary fallback={<div>Fallback UI Rendered</div>}>
        <ThrowingChild />
      </ErrorBoundary>
    );

    expect(screen.getByText("Fallback UI Rendered")).toBeInTheDocument();
  });
});