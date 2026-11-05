import { getReviewByToken } from '@/lib/reviews/review-queries';
import { getReviewProvider } from '@/lib/reviews/review-provider';
import { ReviewForm } from './review-form';

function MessageState({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-lg rounded-lg border border-border-strong bg-surface p-8 text-center">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{body}</p>
      </div>
    </main>
  );
}

export default async function ReviewPage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const review = await getReviewByToken(token);

  if (!review) {
    return (
      <MessageState
        title="This link isn't valid"
        body="It may be incorrect or no longer active. Please contact us if you have any questions about your visit."
      />
    );
  }

  // COMPLIANCE: the public-review link is resolved up front and shown to EVERYONE
  // after they respond — there is no sentiment branch that hides it from low
  // raters. The org id isn't disclosed by the token; the provider link is the
  // same for the org, so a placeholder is safe.
  const publicReviewUrl = getReviewProvider().getPublicReviewUrl('self');

  if (review.status === 'responded') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-lg rounded-lg border border-border-strong bg-surface p-8 text-center">
          <h1 className="text-xl font-semibold text-foreground">
            Thank you for your feedback!
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            We&apos;ve already recorded your response. If you have a moment, a
            public review really helps us out.
          </p>
          <a
            href={publicReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition-[background-color] duration-[var(--dur-hover)] hover:bg-primary-deep"
          >
            Leave a public review
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-canvas p-4 sm:p-6">
      <div className="mx-auto max-w-lg rounded-lg border border-border-strong bg-surface p-6 sm:p-8">
        <header className="mb-6 text-center">
          <h1 className="font-heading text-[26px] leading-[30px] font-semibold tracking-[-0.02em] text-foreground">
            How did we do?
          </h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            Your feedback helps us serve you better.
          </p>
        </header>
        <ReviewForm token={token} publicReviewUrl={publicReviewUrl} />
      </div>
    </main>
  );
}
