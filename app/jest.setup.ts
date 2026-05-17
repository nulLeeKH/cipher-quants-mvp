// Runs in `setupFilesAfterEach`-equivalent (after Jest is set up). This is
// where matchers register: `expect` must exist before jest-dom imports.
import "@testing-library/jest-dom";
