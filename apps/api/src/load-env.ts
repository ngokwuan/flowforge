import { config } from 'dotenv';
import { validateEnv } from './config/env';

config({ path: '../../.env' });
validateEnv(process.env);
