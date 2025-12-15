import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import { Canvas } from '../../ai-elements/canvas';
import { Button } from '../../shadcn/button';
import type { SchemaGraphMetadata, TableNode } from './types';
import { SchemaGraphLegend } from './legend';
import { SchemaSelector } from './schema-selector';
import { TableNode as TableNodeComponent } from './table-node';
import {
  getGraphDataFromMetadata,
  getLayoutedElementsViaDagre,
  getLayoutedElementsViaLocalStorage,
} from './utils';

export interface SchemaGraphProps {
  metadata: SchemaGraphMetadata | null | undefined;
  storageKey?: string;
}

const SchemaGraphInner = ({ metadata, storageKey }: SchemaGraphProps) => {
  const [selectedSchemas, setSelectedSchemas] = useState<string[]>([]);
  const isInitialLayoutDoneRef = useRef(false);

  const reactFlowInstance = useReactFlow<TableNode, Edge>();

  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      table: TableNodeComponent,
    }),
    [],
  );

  const { nodes, edges } = useMemo(
    () => getGraphDataFromMetadata(metadata, selectedSchemas),
    [metadata, selectedSchemas],
  );

  useEffect(() => {
    if (!metadata?.tables?.length) return;

    const savedPositionsRaw =
      storageKey && typeof window !== 'undefined'
        ? window.localStorage.getItem(storageKey)
        : null;
    const savedPositions = savedPositionsRaw
      ? (JSON.parse(savedPositionsRaw) as Record<
          string,
          { x: number; y: number }
        >)
      : null;

    const { nodes: layoutNodes, edges: layoutEdges } = savedPositions
      ? getLayoutedElementsViaLocalStorage(nodes, edges, savedPositions)
      : getLayoutedElementsViaDagre(nodes, edges);

    reactFlowInstance.setNodes(layoutNodes);
    reactFlowInstance.setEdges(layoutEdges);
    setTimeout(() => {
      reactFlowInstance.fitView({});
      isInitialLayoutDoneRef.current = true;
    }, 0);
  }, [metadata, nodes, edges, reactFlowInstance, storageKey]);

  const saveNodePositions = useCallback(() => {
    if (!storageKey) return;
    const currentNodes = reactFlowInstance.getNodes();
    if (!currentNodes.length) return;

    const positions = currentNodes.reduce<
      Record<string, { x: number; y: number }>
    >((acc, node) => {
      acc[node.id] = node.position;
      return acc;
    }, {});

    window.localStorage.setItem(storageKey, JSON.stringify(positions));
  }, [storageKey, reactFlowInstance]);

  const resetLayout = () => {
    const currentNodes = reactFlowInstance.getNodes();
    const currentEdges = reactFlowInstance.getEdges();

    const { nodes: layoutNodes, edges: layoutEdges } =
      getLayoutedElementsViaDagre(
        currentNodes as unknown as TableNode[],
        currentEdges,
      );

    reactFlowInstance.setNodes(layoutNodes);
    reactFlowInstance.setEdges(layoutEdges);
    setTimeout(() => reactFlowInstance.fitView({}), 0);
    saveNodePositions();
  };

  if (!metadata) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-muted-foreground text-sm">
          No metadata available for this datasource.
        </p>
      </div>
    );
  }

  if (!metadata.tables?.length) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-muted-foreground text-sm">
          This datasource has no tables.
        </p>
      </div>
    );
  }

  const miniMapNodeColor = '#111318';
  const miniMapMaskColor = 'rgba(0,0,0,0.2)';

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b p-4">
        <div className="flex items-center gap-3">
          <SchemaSelector
            metadata={metadata}
            selectedSchemas={selectedSchemas}
            onChange={setSelectedSchemas}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={resetLayout}
          >
            Auto layout
          </Button>
        </div>
        <div className="text-muted-foreground text-xs">
          Schema graph · Guepard
        </div>
      </div>

      <div className="relative h-full w-full">
        <Canvas
          defaultNodes={[]}
          defaultEdges={[]}
          fitView={false}
          nodeTypes={nodeTypes}
          proOptions={{ hideAttribution: true }}
          onNodeDragStop={() => {
            if (isInitialLayoutDoneRef.current) {
              saveNodePositions();
            }
          }}
        >
          <Background
            gap={16}
            className="[&>*]:stroke-muted opacity-[25%]"
            variant={BackgroundVariant.Dots}
            color="inherit"
          />
          <MiniMap
            pannable
            zoomable
            nodeColor={miniMapNodeColor}
            maskColor={miniMapMaskColor}
            className="rounded-md border shadow-sm"
          />
          <SchemaGraphLegend />
        </Canvas>
      </div>
    </div>
  );
};

export const SchemaGraph = (props: SchemaGraphProps) => {
  return (
    <ReactFlowProvider>
      <SchemaGraphInner {...props} />
    </ReactFlowProvider>
  );
};
