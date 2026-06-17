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
    <main className="mx-auto flex min-h-screen max-w-lg items-center justify-center p-6">
      <div className="w-full rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{body}</p>
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
        title="Review link not found"
        body="This link may be incorrect or is no longer available. Please contact us if you need a new copy."
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
      <main className="mx-auto flex min-h-screen max-w-lg items-center justify-center p-6">
        <div className="w-full rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-gray-900">
            Thank you for your feedback!
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            We&apos;ve already recorded your response. If you have a moment, a
            public review really helps us out.
          </p>
          <a
            href={publicReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex items-center justify-center rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
          >
            Leave a public review
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            How did we do?
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Your feedback helps us serve you better.
          </p>
        </header>
        <ReviewForm token={token} publicReviewUrl={publicReviewUrl} />
      </div>
    </main>
  );
}
