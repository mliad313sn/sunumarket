-- DropIndex
DROP INDEX "delivery_points_point_gist";

-- DropIndex
DROP INDEX "job_events_gps_gist";

-- DropIndex
DROP INDEX "zones_polygon_gist";

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "contact_user_id" UUID;
