// Links into the Stripe Dashboard for staff-facing pages and alerts. Live vs
// test is inferred from the secret-key mode.
export function stripeCustomerUrl(customerId: string, secretKey: string | undefined): string {
  const test = secretKey?.startsWith('sk_test_') ?? false
  return `https://dashboard.stripe.com/${test ? 'test/' : ''}customers/${customerId}`
}
