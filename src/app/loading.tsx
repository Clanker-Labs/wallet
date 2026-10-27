/** Shown while a page's data loads: the shape of a page, gently shimmering. */
export default function Loading() {
  return (
    <div className="space-y-5 md:space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <div className="skeleton h-9 w-56 rounded-xl" />
        <div className="skeleton h-4 w-96 max-w-full rounded-lg" />
      </div>
      <div className="skeleton h-72 w-full rounded-2xl" />
      <div className="grid gap-5 md:gap-6 xl:grid-cols-12">
        <div className="skeleton h-48 rounded-2xl xl:col-span-7" />
        <div className="skeleton h-48 rounded-2xl xl:col-span-5" />
      </div>
    </div>
  );
}
