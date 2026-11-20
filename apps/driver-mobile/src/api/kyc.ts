import type { Http } from '@kiwi/mobile-core';

export function kycApi(http: Http) {
  return {
    // Estado de verificación (`GET /kyc/status`). El envío de documentos se
    // hace en el formulario web (PWA /kyc), que la app abre en el navegador.
    status: () => http.get<any>('/kyc/status'),
  };
}
