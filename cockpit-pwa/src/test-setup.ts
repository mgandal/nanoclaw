import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

// Testing Library needs an explicit DOM cleanup between tests to avoid
// leftover mounted components causing duplicate-role / duplicate-text
// assertions to fail. Globally registering here saves repeating in every
// component test file.
afterEach(cleanup);
