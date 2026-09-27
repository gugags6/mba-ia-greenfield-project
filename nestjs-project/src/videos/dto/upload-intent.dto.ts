import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ACCEPTED_VIDEO_MIME_TYPES,
  MAX_VIDEO_SIZE_BYTES,
} from '../videos.constants';

export class UploadIntentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsNotEmpty()
  filename: string;

  /** Client-declared MIME type hint — re-validated authoritatively by the worker via ffprobe. */
  @IsIn(ACCEPTED_VIDEO_MIME_TYPES)
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;
}
