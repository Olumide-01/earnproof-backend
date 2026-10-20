import { IsString, Length } from "class-validator";
import { SESSION_DEVICE_LABEL_MAX_LENGTH } from "../session-device-metadata";

export class RenameSessionDto {
  @IsString()
  @Length(1, SESSION_DEVICE_LABEL_MAX_LENGTH)
  label!: string;
}
