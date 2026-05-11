import type { API } from 'homebridge';

import { FP2Platform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, FP2Platform);
};
