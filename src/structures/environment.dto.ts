import { ApiProperty } from '@nestjs/swagger';

export class WAHABuildEnvironment {
  @ApiProperty({
    example: '79233e09e34831b0ce23223d89b36e49b3024fd9',
    nullable: true,
    description: 'Git revision used to build the running image.',
  })
  revision: string | null;

  @ApiProperty({
    example: '2026.7.2',
    nullable: true,
    description: 'Upstream WAHA version selected by the image build.',
  })
  version: string | null;

  @ApiProperty({
    example: '123456789012.dkr.ecr.us-east-1.amazonaws.com/waha@sha256:...',
    nullable: true,
    description:
      'Immutable image reference injected by the deployment environment.',
  })
  image: string | null;

  @ApiProperty({
    example: 'sha256:...',
    nullable: true,
    description:
      'Resolved image digest injected by the deployment environment.',
  })
  digest: string | null;

  @ApiProperty({
    example: 'https://github.com/Spryx-AI/waha',
    nullable: true,
    description: 'Source repository used to build the running image.',
  })
  source: string | null;
}

export class WAHAEnvironment {
  @ApiProperty({
    example: 'YYYY.MM.BUILD',
  })
  version: string;

  @ApiProperty({
    example: 'WEBJS',
  })
  engine: string;

  @ApiProperty({
    example: 'PLUS',
  })
  tier: string;

  @ApiProperty({
    example: '/usr/path/to/bin/google-chrome',
  })
  browser: string;

  @ApiProperty({
    example: 'linux/x86',
  })
  platform: string;

  @ApiProperty({
    example: {
      id: 'worker-1',
    },
    nullable: true,
    description: 'Worker metadata for the running instance.',
  })
  worker: {
    id: string | null;
  };

  @ApiProperty({
    type: WAHABuildEnvironment,
    description: 'Immutable build and deployment metadata.',
  })
  build: WAHABuildEnvironment;
}
