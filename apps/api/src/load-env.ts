import { config } from 'dotenv';
import { validateEnv } from './config/env';

config({ path: '../../.env', quiet: true });
validateEnv(process.env);
