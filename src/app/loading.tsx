/** Shown while a page's data loads: the shape of a page, gently shimmering. */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-56 w-full" />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="skeleton h-40" />
        <div className="skeleton h-40" />
      </div>
    </div>
  );
}
