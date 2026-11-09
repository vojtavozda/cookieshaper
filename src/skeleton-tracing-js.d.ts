declare module "skeleton-tracing-js/dist/trace_skeleton.js" {
  export type SkeletonPolyline = number[][];

  export interface SkeletonTraceResult {
    polylines: SkeletonPolyline[];
    rects: number[][];
    width: number;
    height: number;
  }

  const TraceSkeleton: {
    /** 1 = foreground. Chunk size ~10 gives cleaner seams on line art. */
    trace(
      im: ArrayLike<number>,
      width: number,
      height: number,
      chunkSize: number,
    ): SkeletonTraceResult;
  };

  export default TraceSkeleton;
}
