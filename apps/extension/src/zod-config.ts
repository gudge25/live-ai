import { z } from 'zod';

// MV3 extension pages forbid eval; stop zod probing `new Function` (CSP errors in the console).
z.config({ jitless: true });
