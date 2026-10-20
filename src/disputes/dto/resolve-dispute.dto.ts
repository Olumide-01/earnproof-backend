import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class ResolveDisputeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  resolution!: string;
}