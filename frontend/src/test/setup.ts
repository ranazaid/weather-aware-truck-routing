import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom does not implement layout APIs the UI calls.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
