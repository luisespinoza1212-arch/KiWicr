import { kycApi } from '../kyc';

const fake = { get: jest.fn(), post: jest.fn() } as any;

test('status GETs /kyc/status', async () => {
  await kycApi(fake).status();
  expect(fake.get).toHaveBeenCalledWith('/kyc/status');
});

test('ya no inicia Didit: solo expone el estado', () => {
  expect(Object.keys(kycApi(fake))).toEqual(['status']);
});
