import { config } from 'dotenv';
import { validateEnv } from './env';

config({ path: '../../.env', quiet: true });
validateEnv(process.env);
