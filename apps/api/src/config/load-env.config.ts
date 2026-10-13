import { config } from 'dotenv';
import { validateEnv } from '../common/pipes/env-validation.pipe';

config({ path: '../../.env', quiet: true });
validateEnv(process.env);
