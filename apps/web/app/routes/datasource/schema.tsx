import { useParams } from 'react-router';

import { SchemaGraph } from '@qwery/ui/schema-graph';
import { useWorkspace } from '~/lib/context/workspace-context';
import { useGetDatasourceBySlug } from '~/lib/queries/use-get-datasources';
import { useGetDatasourceMetadata } from '~/lib/queries/use-get-datasource-metadata';

export default function Schema() {
  const params = useParams();
  const slug = params.slug as string;
  const { repositories } = useWorkspace();

  const { data: datasource, isLoading: isLoadingDatasource } =
    useGetDatasourceBySlug(repositories.datasource, slug);

  const {
    data: metadata,
    isLoading: isLoadingMetadata,
    isError,
  } = useGetDatasourceMetadata(datasource, {
    enabled: !!datasource,
  });

  if (!slug) {
    return null;
  }

  if (isLoadingDatasource || isLoadingMetadata) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading schema...</p>
      </div>
    );
  }

  if (isError || !metadata) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-muted-foreground text-sm">
          Failed to load datasource metadata.
        </p>
      </div>
    );
  }

  const storageKey = `datasource-schema-positions:${datasource?.id ?? slug}`;

  return (
    <div className="h-full w-full">
      <SchemaGraph metadata={metadata} storageKey={storageKey} />
    </div>
  );
}
