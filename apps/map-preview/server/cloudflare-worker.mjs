import {createCloudflarePreview} from './cloudflare-preview.mjs';
import assets from 'easygrid:preview-assets';

export default {
  fetch(request, env) {
    return createCloudflarePreview({database:env.DB,assets})(request);
  },
};
